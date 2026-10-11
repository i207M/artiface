package config

import "errors"

const MaxOpenProjects = 512

// ProjectRef identifies a configured folder without duplicating its path or credentials.
type ProjectRef struct {
	Host string `json:"host"`
	Root string `json:"root"`
}

func (p ProjectRef) Valid() bool { return safeID(p.Host) && safeID(p.Root) }

func validateOpenProjects(projects []ProjectRef) error {
	if len(projects) > MaxOpenProjects {
		return errors.New("too many open projects")
	}
	seen := make(map[ProjectRef]bool, len(projects))
	for _, project := range projects {
		if !project.Valid() || seen[project] {
			return errors.New("openProjects must contain unique, valid host and root identifiers")
		}
		seen[project] = true
	}
	return nil
}

func (c Config) ProjectVisible(project ProjectRef) bool {
	for _, host := range c.Hosts {
		if host.ID != project.Host || host.Hidden {
			continue
		}
		for _, root := range host.Roots {
			if root.ID == project.Root && !root.Hidden {
				return true
			}
		}
	}
	return false
}

// Hidden or removed sources must not reappear as open projects when restored.
func (c *Config) PruneOpenProjects() {
	c.pruneUserProjects()
	projects := make([]ProjectRef, 0, len(c.OpenProjects))
	for _, project := range c.OpenProjects {
		if c.ProjectVisible(project) {
			projects = append(projects, project)
		}
	}
	c.OpenProjects = projects
}
